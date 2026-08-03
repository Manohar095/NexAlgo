# -*- coding: utf-8 -*-
"""
main.py
========
Entry point. Run with:  python main.py
Then open:               http://localhost:8000
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from utils.logging_setup import configure_logging
configure_logging()  # console + logs/renko_platform.log (rotated daily) — set up before anything else logs

from api.routes import router as api_router
from database import db
from services.instance_manager import instance_manager
from ws_broadcast.ws_manager import ws_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    ws_manager.set_loop(asyncio.get_event_loop())
    instance_manager.set_callbacks(on_log=ws_manager.on_log, on_status=ws_manager.on_status)
    # Restore saved symbols; auto-start the ones flagged autostart=True
    instance_manager.load_from_db(autostart_saved=True)
    logging.info("🚀 Zenith Trading Terminal ready at http://localhost:8000")
    yield
    logging.info("🛑 Shutting down — stopping all running symbols")
    for status in instance_manager.all_statuses():
        if status["status"] == "RUNNING":
            try:
                instance_manager.stop(status["id"])
            except Exception as e:
                logging.error("Error stopping %s during shutdown → %s", status["id"], e)


app = FastAPI(title="Zenith Trading Terminal", lifespan=lifespan)

app.include_router(api_router)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("templates/index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # keepalive / ignored
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn
    from config.settings import settings
    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=False)
