/** Matches http(s)://localhost|127.0.0.1|0.0.0.0 with a port number. Uses `g` flag — reset lastIndex before reuse. */
export const DEV_SERVER_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/g
