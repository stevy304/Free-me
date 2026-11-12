# Streamlabs and OBS → Free Me

Free Me supports a **custom RTMP/RTMPS destination**. Premium creators open **Signal Room → Sources → Connect your streaming software**. No Streamlabs partnership or direct account integration is required for custom ingest.

1. Enter a title and click **Save broadcast title**. Set visibility, recording and chat with **Save settings**.
2. Select Streamlabs, OBS Studio or Other encoder in the connection panel.
3. In Streamlabs Desktop, open Settings → Stream → Stream to custom ingest. In OBS, open Settings → Stream → Service: Custom.
4. Copy the **Server URL** and **Stream key** into their separate fields. Never paste a YouTube key into Free Me.
5. Start with H.264 video, AAC stereo at 128 kbps / 48 kHz, 720p30 at 2,500–4,000 kbps, CBR, and a 2-second keyframe interval. These are starting settings; reduce bitrate for weaker connections.
6. Start Streaming in your encoder. **The broadcast goes live immediately** when authenticated; this is not a private preview. Choose Unlisted before connecting if you want a link-only rehearsal.
7. Check the watch page for moving video and sound. “Encoder connected” reports accepted ingest, not a measured guarantee of playback quality.
8. Stop streaming in your encoder when finished. Signal Room can also end the broadcast and replace its key to prevent automatic reconnects; nginx must have the `on_update` configuration below to disconnect the existing sender. Copy the new key before your next broadcast.

The browser studio's scenes, graphics and audio mixer affect browser broadcasts. Streamlabs/OBS supplies its own finished program feed. Direct Google/YouTube OAuth linking, and forwarding a Free Me broadcast to YouTube, are separate integrations and are not implemented by this custom-ingest flow.

## Production RTMPS

Use a dedicated media host or IP. RTMPS is RTMP carried over **TLS over TCP**. YouTube uses TCP port 443 for its RTMPS ingest; Free Me can use the same convention. RTMP commonly uses TCP 1935. This is not UDP.

Install nginx with `libnginx-mod-rtmp`, stunnel4, and a valid automatically renewed certificate for your actual ingest hostname. The sample files in `deploy/live/` require local addresses, certificate paths and the callback secret to be replaced before use.

- Keep nginx's plaintext ingest on `127.0.0.1:1935`.
- Terminate TLS with stunnel on `443` and forward to the loopback listener.
- A web server already bound to the same IP and port 443 conflicts with this listener. Use a dedicated media host/IP, or select another public TLS port and include it in `LIVE_RTMP_URL`.
- Set `LIVE_RTMP_URL=rtmps://YOUR_INGEST_HOST:443/live` on the API and set `LIVE_RTMP_SECRET` to the same randomly generated value used in nginx callbacks (at least 24 characters).
- Set `LIVE_RTMP_HLS_DIR=/var/lib/freeme/live` on the worker. Run the worker on this media host so it can read nginx's HLS files. Use the same PostgreSQL, Redis and object storage as the API.
- The sample nginx callback address is a private API address. Restrict it to the media host. Avoid recording callback query strings or encoder arguments in proxy/debug logs: they contain secrets.
- Allow inbound TCP 443 to the media host. Do not expose plaintext port 1935 when using TLS-only ingest.
- Give nginx write access and the media worker read/write access to the HLS directory, for example with the existing `freeme` group and mode 2775.
- Configure stunnel's service to read the certificate and private key securely. Reload stunnel after certificate renewal. Do not weaken verification in the encoder or use a self-signed certificate in production.
- Validate nginx using `nginx -t`, then reload nginx and restart the distribution's stunnel service after reviewing its service configuration.

`on_publish` checks the creator key, active account and Premium eligibility, and redirects nginx to the stream UUID. Public playback URLs use this UUID, never the secret key. `on_update` rechecks the active broadcast every five seconds and rejects an ended or unauthorized stream. `notify_update_strict on` also disconnects if the authorization API becomes unreachable; maintain a reliable private API path.

Replacing a key invalidates the old key for future connections. Replacement is blocked while an external broadcast is live: stop the encoder first. Ending an external broadcast from Signal Room automatically replaces the key, so automatic encoder reconnects cannot start another broadcast with the old key. Stopping normally in Streamlabs/OBS keeps the key for the next session.

## Verification before launch

- Streamlabs and OBS can publish to the configured TLS endpoint with a valid key; the matching Free Me watch page plays video and sound.
- Incorrect keys and incorrect callback secrets are rejected.
- Public announcements are sent only for Public broadcasts; Unlisted broadcasts do not notify followers.
- Stop the encoder and verify that the stream ends and its replay follows the recording setting.
- Click End broadcast with `on_update` configured; the existing ingest connection is rejected at the next authorization check.
- Replace a stopped encoder's key, then verify that the previous key no longer connects.
- Verify certificate renewal/reload, both target mobile networks and representative stream durations.

## References

- Streamlabs custom ingest: https://streamlabs.com/content-hub/post/how-to-stream-new-platform-custom-ingest
- YouTube RTMPS transport: https://developers.google.com/youtube/data/live/guides/rtmps-ingestion
- nginx-rtmp notification directives: https://github.com/arut/nginx-rtmp-module/wiki/Directives#notify
