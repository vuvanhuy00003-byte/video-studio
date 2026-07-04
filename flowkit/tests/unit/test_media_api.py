"""Unit tests for media upload reference attachment."""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from agent.api.media import attach_uploaded_reference


MEDIA_ID = "550e8400-e29b-41d4-a716-446655440000"
ENTITY_ID = "entity-001"
PROJECT_ID = "project-001"


@pytest.mark.asyncio
async def test_attach_uploaded_reference_updates_and_links_entity():
    with patch("agent.api.media.crud") as mock_crud:
        mock_crud.get_character = AsyncMock(return_value={"id": ENTITY_ID})
        mock_crud.get_project = AsyncMock(return_value={"id": PROJECT_ID})
        mock_crud.update_character = AsyncMock()
        mock_crud.link_character_to_project = AsyncMock(return_value=True)

        result = await attach_uploaded_reference(
            MEDIA_ID, ENTITY_ID, PROJECT_ID, "https://example.com/reference.png"
        )

    mock_crud.update_character.assert_awaited_once_with(
        ENTITY_ID,
        media_id=MEDIA_ID,
        reference_image_url="https://example.com/reference.png",
    )
    mock_crud.link_character_to_project.assert_awaited_once_with(PROJECT_ID, ENTITY_ID)
    assert result == {"entityId": ENTITY_ID, "projectId": PROJECT_ID}


@pytest.mark.asyncio
async def test_attach_uploaded_reference_does_nothing_without_entity():
    with patch("agent.api.media.crud") as mock_crud:
        result = await attach_uploaded_reference(MEDIA_ID, None, PROJECT_ID)

    mock_crud.update_character.assert_not_called()
    assert result is None


@pytest.mark.asyncio
async def test_attach_uploaded_reference_rejects_unknown_entity():
    with patch("agent.api.media.crud") as mock_crud:
        mock_crud.get_character = AsyncMock(return_value=None)

        with pytest.raises(HTTPException) as exc:
            await attach_uploaded_reference(MEDIA_ID, ENTITY_ID, PROJECT_ID)

    assert exc.value.status_code == 404
