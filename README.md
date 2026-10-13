# Aura RIFAT Portfolio — GitHub Pages

This is a Vite + React static website. GitHub Actions builds the site and deploys the generated `dist/` folder to GitHub Pages whenever you push to `main` or `master`.

## Deploy from your phone

1. Create/open your GitHub repository and upload **the contents of this ZIP**, not the ZIP file itself. Keep hidden files/folders such as `.github` and `.nojekyll`.
2. Make sure the workflow is at `.github/workflows/deploy.yml` and your default branch is `main` (or `master`).
3. In GitHub, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
4. Open the **Actions** tab and wait for **Deploy Aura RIFAT Portfolio to GitHub Pages** to finish with a green check mark.
5. Open **Settings → Pages** to find the published website URL. Every later push to `main`/`master` triggers another deployment.

## Important GitHub Pages limitations

GitHub Pages only hosts static files; it does not run `server.ts` or an Express backend. The portfolio's main content can load from `public/data/siteData.json`, and local browser edits may be saved in that browser, but these backend features will not work on GitHub Pages without a separate backend: shared admin edits, image uploads through `/api/upload`, live visitor counts, and server-side image resolving. Browser-local edits do not sync to other visitors/devices.

**Security:** never put passwords, API keys, or other secrets in frontend source, `.env` files committed to GitHub, or client-side JavaScript. Any credentials embedded in a frontend bundle can be viewed by visitors. Use a secure backend for authenticated admin/CMS features.

## Local development

Requires Node.js 22 or newer and npm.

```bash
npm ci
npm run dev
```

Build and preview the static output:

```bash
npm run build
npm run preview
```

The production output is written to `dist/`.
