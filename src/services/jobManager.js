const activeJobs = new Map();
const pauseRequests = new Set();
// Map projectId -> AbortController, used to abort in-flight requests when pausing
const pauseControllers = new Map();

// Hàng đợi cho các tác vụ nặng cấp dự án
const projectQueue = [];
const runningProjects = new Map(); // jobId -> job info

const { getSettings } = require('./settingsService');

function startJob(jobId, runner) {
  const isHeavy = !jobId.includes(':');
  if (isHeavy) {
    return enqueueProjectJob(jobId, runner);
  }

  // Tác vụ nhẹ (scene-level) thực thi ngay lập tức
  if (activeJobs.has(jobId)) {
    return activeJobs.get(jobId);
  }
  const projectId = jobId.split(':')[0];
  clearPauseRequest(projectId);
  const promise = Promise.resolve()
    .then(runner)
    .finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, promise);
  return promise;
}

function getHeavyJob(jobId) {
  // Tìm trong hàng đợi
  const enqueued = projectQueue.find(item => item.jobId === jobId);
  if (enqueued) return enqueued;
  // Tìm trong danh sách đang chạy
  const running = runningProjects.get(jobId);
  if (running) return running;
  return null;
}

function enqueueProjectJob(jobId, runner) {
  const existing = getHeavyJob(jobId);
  if (existing) {
    return existing.promise;
  }

  const projectId = jobId;
  clearPauseRequest(projectId);

  // Đổi trạng thái sang 'queued' (Đang xếp hàng) ngay lập tức
  try {
    const { getProject, saveProject } = require('./projectService');
    const { appendProjectLog } = require('../lib/logger');
    const { getProjectPaths } = require('./projectService');

    getProject(projectId).then(async (project) => {
      if (project && project.status !== 'running' && project.status !== 'queued') {
        project.status = 'queued';
        await saveProject(project, { overwrite: true });
        const paths = getProjectPaths(projectId);
        await appendProjectLog(paths.projectDir, 'info', 'Dự án đã được đưa vào hàng đợi (Đang xếp hàng)...');
      }
    }).catch(() => {});
  } catch (e) {
    // Bỏ qua lỗi nạp module chéo
  }

  const queuedJob = {
    jobId,
    projectId,
    runner,
    resolve: null,
    reject: null,
    promise: null
  };

  queuedJob.promise = new Promise((resolve, reject) => {
    queuedJob.resolve = resolve;
    queuedJob.reject = reject;
  });

  projectQueue.push(queuedJob);
  processQueue().catch(err => console.error("Error processing queue", err));

  return queuedJob.promise;
}

async function processQueue() {
  const settings = await getSettings().catch(() => ({}));
  const concurrencyLimit = settings.projectConcurrency || 1;

  while (runningProjects.size < concurrencyLimit && projectQueue.length > 0) {
    const job = projectQueue.shift();

    // Khởi chạy tiến trình thực thi thực tế
    const runPromise = (async () => {
      clearPauseRequest(job.projectId);

      try {
        const { appendProjectLog } = require('../lib/logger');
        const { getProjectPaths } = require('./projectService');
        const paths = getProjectPaths(job.projectId);
        await appendProjectLog(paths.projectDir, 'info', 'Đã bắt đầu thực thi dự án từ hàng đợi...');
      } catch (err) {
        // Bỏ qua
      }

      try {
        const result = await job.runner();
        job.resolve(result);
        return result;
      } catch (error) {
        job.reject(error);
        throw error;
      } finally {
        runningProjects.delete(job.jobId);
        processQueue(); // Kích hoạt chạy tiếp hàng đợi
      }
    })();

    runningProjects.set(job.jobId, {
      jobId: job.jobId,
      projectId: job.projectId,
      promise: job.promise,
      runPromise
    });
  }
}

function isJobRunning(jobId, exact = false) {
  if (exact) {
    if (activeJobs.has(jobId)) return true;
    if (getHeavyJob(jobId)) return true;
    return false;
  }

  if (activeJobs.has(jobId)) return true;
  if (getHeavyJob(jobId)) return true;

  for (const key of activeJobs.keys()) {
    if (key.startsWith(`${jobId}:`)) {
      return true;
    }
  }

  for (const key of runningProjects.keys()) {
    if (key.startsWith(`${jobId}:`) || key === jobId) {
      return true;
    }
  }

  for (const job of projectQueue) {
    if (job.jobId === jobId) {
      return true;
    }
  }

  return false;
}

function requestPause(projectId) {
  pauseRequests.add(projectId);

  // Abort any in-flight HTTP requests (Chat01, image fetch, etc.) immediately
  const controller = pauseControllers.get(projectId);
  if (controller) {
    try { controller.abort(new Error('Tạm dừng bởi người dùng')); } catch (e) {}
    pauseControllers.delete(projectId);
  }

  // Nếu dự án đang nằm trong hàng đợi chờ chạy, loại bỏ khỏi hàng đợi và đánh dấu tạm dừng
  const idx = projectQueue.findIndex(item => item.projectId === projectId);
  if (idx !== -1) {
    const job = projectQueue[idx];
    projectQueue.splice(idx, 1);
    job.reject(new Error('Đã hủy khỏi hàng đợi bởi người dùng (Tạm dừng)'));

    try {
      const { getProject, saveProject } = require('./projectService');
      const { appendProjectLog } = require('../lib/logger');
      const { getProjectPaths } = require('./projectService');

      getProject(projectId).then(async (project) => {
        if (project) {
          project.status = 'paused';
          await saveProject(project, { overwrite: true });
          const paths = getProjectPaths(projectId);
          await appendProjectLog(paths.projectDir, 'info', 'Đã hủy dự án khỏi hàng đợi và chuyển sang trạng thái tạm dừng.');
        }
      }).catch(() => {});
    } catch (e) {
      // Bỏ qua
    }
  }
}

// Create and register an AbortController linked to the pause mechanism for a project.
// The pipeline calls this before each long network call and passes the signal to fetch().
function createPauseSignal(projectId) {
  // Clean up any previous controller
  const prev = pauseControllers.get(projectId);
  if (prev) { try { prev.abort(); } catch (e) {} }

  const controller = new AbortController();
  pauseControllers.set(projectId, controller);

  // Combine with the pause request state: if already paused, abort immediately
  if (pauseRequests.has(projectId)) {
    try { controller.abort(new Error('Tạm dừng bởi người dùng')); } catch (e) {}
  }

  return controller.signal;
}

function clearPauseSignal(projectId) {
  pauseControllers.delete(projectId);
}

function isPauseRequested(projectId) {
  return pauseRequests.has(projectId);
}

function clearPauseRequest(projectId) {
  pauseRequests.delete(projectId);
}

function getActiveJobsForProject(projectId) {
  const list = [];
  for (const key of activeJobs.keys()) {
    if (key === projectId || key.startsWith(`${projectId}:`)) {
      list.push(key);
    }
  }
  for (const key of runningProjects.keys()) {
    if (key === projectId || key.startsWith(`${projectId}:`)) {
      list.push(key);
    }
  }
  for (const job of projectQueue) {
    if (job.jobId === projectId || job.jobId.startsWith(`${projectId}:`)) {
      list.push(job.jobId);
    }
  }
  return list;
}

module.exports = {
  startJob,
  isJobRunning,
  requestPause,
  isPauseRequested,
  clearPauseRequest,
  createPauseSignal,
  clearPauseSignal,
  getActiveJobsForProject
};

