"""Media upload helpers."""
import base64
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agent.db import crud
from agent.services.flow_client import get_flow_client

router = APIRouter(prefix="/media", tags=["media"])


class ImageUploadBody(BaseModel):
    project_id: str = ""
    entity_id: str | None = None
    file_name: str = "reference-image.png"
    mime_type: str = "image/png"
    image_base64: str | None = None
    url: str | None = None


async def attach_uploaded_reference(
    media_id: str,
    entity_id: str | None,
    project_id: str = "",
    reference_image_url: str | None = None,
) -> dict | None:
    if not entity_id:
        return None
    if not await crud.get_character(entity_id):
        raise HTTPException(404, f"Entity not found: {entity_id}")
    if project_id and not await crud.get_project(project_id):
        raise HTTPException(404, f"Project not found: {project_id}")
    updates = {"media_id": media_id}
    if reference_image_url:
        updates["reference_image_url"] = reference_image_url
    await crud.update_character(entity_id, **updates)
    if project_id:
        if not await crud.link_character_to_project(project_id, entity_id):
            raise HTTPException(400, "Failed to link entity to project")
    return {"entityId": entity_id, "projectId": project_id or None}


def _safe_file_name(value: str) -> str:
    name = (value or "reference-image.png").split("/")[-1].split("?")[0].strip()
    return name or "reference-image.png"


async def _download_image(url: str) -> tuple[str, str, str]:
    parsed = urlparse(url or "")
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(400, "Only http/https image URLs are supported")
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        response = await client.get(url, headers={"User-Agent": "FlowKit/1.1", "Accept": "image/*,*/*;q=0.8"})
    if response.status_code >= 400:
        raise HTTPException(400, f"Cannot download image: HTTP {response.status_code}")
    mime_type = response.headers.get("content-type", "image/png").split(";")[0].strip()
    if not mime_type.startswith("image/") and mime_type != "application/octet-stream":
        raise HTTPException(400, f"URL is not an image: {mime_type}")
    return base64.b64encode(response.content).decode("utf-8"), mime_type, _safe_file_name(parsed.path)


@router.post("/upload-image")
async def upload_image(body: ImageUploadBody):
    image_base64 = body.image_base64
    mime_type = body.mime_type or "image/png"
    file_name = _safe_file_name(body.file_name)
    if not image_base64 and body.url:
        image_base64, mime_type, file_name = await _download_image(body.url)
    if not image_base64:
        raise HTTPException(400, "Missing image_base64 or url")

    result = await get_flow_client().upload_image(
        image_base64,
        mime_type=mime_type,
        project_id=body.project_id,
        file_name=file_name,
    )
    if result.get("error"):
        raise HTTPException(502, str(result.get("error")))
    media_id = result.get("_mediaId")
    if not media_id:
        raise HTTPException(502, f"Flow did not return media id: {str(result)[:300]}")
    attached = await attach_uploaded_reference(media_id, body.entity_id, body.project_id, body.url)
    return {"mediaId": media_id, "mimeType": mime_type, "fileName": file_name, "attached": attached}
