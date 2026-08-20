# Self Update NODE_ENV Note

Date: 2026-08-06

The CFS self-update worker can be launched from a running `next dev` server. In that case, the child PowerShell process may inherit `NODE_ENV=development`.

`scripts/update-cfs-app.ps1` must force `NODE_ENV=production` only while running:

- `npm run build`
- `npm run start`

Do not force `NODE_ENV=production` around `npm ci`, because dependency installation must still include the dev dependencies needed by the build.
