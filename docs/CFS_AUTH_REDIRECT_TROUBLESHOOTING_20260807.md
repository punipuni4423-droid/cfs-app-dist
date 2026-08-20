# CFS Microsoft Sign-In Redirect Troubleshooting

## Symptom

After Microsoft sign-in, Chrome may show:

```text
This site can't be reached
127.0.0.1 refused to connect
ERR_CONNECTION_REFUSED
```

## Cause

Microsoft/Supabase sign-in returned to a local callback URL such as `http://127.0.0.1:3000/`, but CFS was actually running on a different local port such as `http://localhost:3014/` or `http://localhost:3018/`.

The CFS client requests the current page origin as the OAuth redirect target. However, if the hosted Supabase Auth allow-list or Site URL falls back to port `3000`, the browser can be sent to a port where no CFS server is running.

## Current Mitigation

`START_CFS_APP.bat` now starts a lightweight local redirect helper on port `3000` when the main CFS port is different.

If sign-in returns to:

```text
http://127.0.0.1:3000/#access_token=...
```

the helper serves a small local page that preserves the URL hash/search and redirects the browser to the actual running CFS URL:

```text
http://localhost:<current CFS port>/#access_token=...
```

The helper only contains public local redirect logic. It does not store Supabase tokens, Microsoft tokens, Service Role keys, or project data.

## If It Still Happens

1. Ask the user to launch CFS again with `LAUNCH_CFS_APP.vbs`.
2. Confirm `artifacts\startup\latest-status.txt` says `CFS is ready at http://localhost:<port>`.
3. Ask for the full browser address bar URL from the error page, including the port.
4. In hosted Supabase Auth settings, confirm every real CFS local URL used for OAuth is registered, especially:
   - `http://localhost:3014`
   - `http://127.0.0.1:3014`
   - any actively used custom port, such as `3018`

