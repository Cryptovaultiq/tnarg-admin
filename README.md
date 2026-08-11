# Admin Panel

This folder is a standalone admin-panel app. It can be moved to its own GitHub repository and deployed to its own Vercel project.

## Paths

- Entry file: `index.html`
- Script: `admin.js`
- No parent repo paths are used. The app loads `admin.js` from the same folder.

## Data flow note

The original page stored submissions in browser `localStorage` under `treasuryApplications`. That only works when the visitor page and admin panel run on the same browser and same origin.

For separate Vercel deployments, localStorage cannot be shared. Use a legitimate shared backend/database and configure the admin app before `admin.js` loads:

```html
<script>
window.ADMIN_PANEL_CONFIG = {
  API_BASE_URL: 'https://your-api.example.com',
  USERNAME: 'replace-demo-login',
  PASSWORD: 'replace-demo-password'
};
</script>
<script src="admin.js"></script>
```

Expected API shape if configured:

- `GET /applications` returns an array of application records.
- `PUT /applications/:id` accepts an updated application record.

Do not use the demo username/password for production. Production auth should be handled server-side or by an auth provider.

> Note: This repository has been updated with a harmless documentation-only change to trigger a fresh Vercel redeploy.
