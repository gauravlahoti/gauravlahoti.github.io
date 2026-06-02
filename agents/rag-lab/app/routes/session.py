from fastapi import APIRouter
from app.state import session

router = APIRouter()


@router.post("/api/session/reset")
async def reset_session():
    session.reset()
    return {"status": "reset", "message": "Session cleared — ready for a new document."}
