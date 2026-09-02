"""
Config settings for option chain streamer.
Mirrors the pattern used in the existing search/quotes app.py so the
BrokerSession / broker client code can be shared as-is.
"""
import os


class Settings:
    # Flattrade credentials (same shape as the existing app)
    FT_USER = os.environ.get("FT_USER", "")
    FT_ACCESS_TOKEN = os.environ.get("FT_ACCESS_TOKEN", "")

    # Flattrade REST base
    PI_BASE_URL = "https://piconnect.flattrade.in/PiConnectAPI"

    # Flattrade WebSocket endpoint for tick feed
    # (adjust to the exact endpoint your BrokerSession already connects to)
    FT_WS_URL = os.environ.get("FT_WS_URL", "wss://piconnect.flattrade.in/PiConnectWSTp/")

    # Default option chain params
    DEFAULT_STRIKE_COUNT = int(os.environ.get("DEFAULT_STRIKE_COUNT", "5"))

    # Flask-SocketIO
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")


settings = Settings()
