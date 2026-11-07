"""Public URLs through Cloudflare (in front of the public Hetzner buckets) and cache purges."""

import logging

import requests

from app.config import get_settings
from app.services import hetzner_storage as hz

log = logging.getLogger(__name__)


def base(kind: str) -> str:
    s = get_settings()
    url = (s.cdn_thumbs_url if kind == "thumbs" else s.cdn_stream_url) or s.hetzner_cdn_url
    return url.rstrip("/")


def public_url(kind: str, key: str | None) -> str | None:
    return f"{base(kind)}/{key}" if key else None


def url_for(kind: str, key: str | None, public: bool, expires: int = 7200) -> str | None:
    """CDN URL for public files, a signed Hetzner URL (2 h) for private ones."""
    if not key:
        return None
    return public_url(kind, key) if public else hz.get_signed_url(kind, key, expires)


def purge(urls: list[str]) -> bool:
    """Drops changed playlists from the Cloudflare cache (no-op without CLOUDFLARE_ZONE_ID/API_TOKEN)."""
    s = get_settings()
    if not (s.cloudflare_zone_id and s.cloudflare_api_token and urls):
        return False
    try:
        r = requests.post(f"https://api.cloudflare.com/client/v4/zones/{s.cloudflare_zone_id}/purge_cache",
                          headers={"Authorization": f"Bearer {s.cloudflare_api_token}"}, json={"files": urls[:30]}, timeout=10)
        return r.ok
    except requests.RequestException as e:
        log.warning("cloudflare purge failed: %s", e)
        return False
