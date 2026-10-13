# Staff Punch Backend

Attendance server for the Staff Punch app: punch IN/OUT with selfie + GPS, work from home, Hindi/English messages and an app lock (blocks social apps while an employee is punched in).

- No native modules (no better-sqlite3), runs seamlessly across environments.
- Supports **Vercel Serverless Functions** (`api/index.js` + `vercel.json`) and traditional Node hosts (VPS, Render, Railway, Pterodactyl).
- Data storage: JSON store and selfies directory (uses `/tmp` automatically on serverless platforms).

---

## 🚀 Deploying to Vercel

1. **Push to GitHub**:
   Push this repository to your GitHub account (e.g. `himahsu55/pp-sarvar`).

2. **Import into Vercel**:
   - Go to [vercel.com](https://vercel.com) and log in.
   - Click **"Add New..."** -> **"Project"**.
   - Select your GitHub repository (`pp-sarvar`).
   - Framework Preset: **Other**.
   - Root Directory: `./` (default).

3. **Configure Environment Variables** in Vercel:
   Go to the **Environment Variables** section in the Vercel project settings and add:
   - `JWT_SECRET`: A long random secret key (e.g. generated via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - `ADMIN_ID`: `admin` (or your preferred admin username).
   - `ADMIN_PASSWORD`: A secure password (minimum 8 characters).
   - `OFFICE_LAT`: Your office latitude (e.g. `21.754128`).
   - `OFFICE_LNG`: Your office longitude (e.g. `72.991026`).
   - `OFFICE_RADIUS_METERS`: Allowed radius in meters (e.g. `150`).
   - `MAX_GPS_ACCURACY_METERS`: Maximum allowed GPS accuracy (e.g. `50`).
   - `TZ_OFFSET_MINUTES`: Timezone offset in minutes (e.g. `330` for India Standard Time).

4. **Deploy**:
   - Click **Deploy**.
   - Once deployed, your backend URL will be: `https://your-project.vercel.app`.
   - Test by visiting `https://your-project.vercel.app/` or `https://your-project.vercel.app/api/health`.

> **Note on Serverless Storage on Vercel**:
> Vercel Serverless Functions are stateless and write temporary data into `/tmp`. For long-term production persistence of attendance data across cold starts and deployments, consider hosting on a persistent platform (e.g. Render, Railway, VPS, Pterodactyl) or connecting a cloud database.

---

## 🖥️ Local & VPS / Pterodactyl Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Configure `.env` with your office coordinates, admin password, and `JWT_SECRET`.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```
   Server will listen on `http://0.0.0.0:5331`.

---

## 💾 Backup / Restore (हिंदी में)

- **बैकअप:** `npm run backup` चलाएँ। इससे `data/` (अटेंडेंस और सेल्फी) की कॉपी `backups/<तारीख-समय>/` में बन जाती है।
- **रीस्टोर:** सर्वर बंद करें, `backups/<कॉपी>/` की फाइलें वापस `data/` में डालें, सर्ver चालू करें।

---

## 📡 API Endpoints

**Base Header for Protected Routes:**
`Authorization: Bearer <token>`
`X-App-Lang: hi` or `en` (Optional, defaults to English)

### Public Endpoints
- `GET /`: API status check
- `GET /api/health`: Health status check
- `POST /api/auth/login`: `{ employee_id, password }`

### Employee Endpoints
- `POST /api/auth/change-password`: `{ current_password, new_password }`
- `POST /api/punch/in`: Multipart form with `selfie`, `latitude`, `longitude`, `accuracy`, `is_mocked`
- `POST /api/punch/out`: Multipart form with `selfie`, `latitude`, `longitude`, `accuracy`, `is_mocked`
- `GET /api/punch/today/:employeeId`
- `GET /api/lock/status`
- `POST /api/lock/report`

### Admin Endpoints
- `GET /api/admin/summary`
- `GET /api/admin/employees`
- `POST /api/admin/employees`: `{ employee_id, name, password, shift_start, shift_end, work_mode }`
- `POST /api/admin/employees/:id/password`: `{ password }`
- `PATCH /api/admin/employees/:id`: `{ active: true/false }`
- `POST /api/admin/employees/:id/work-mode`: `{"mode":"WFH"|"OFFICE"}`
- `POST /api/admin/employees/:id/force-unlock`
- `GET /api/admin/lock-settings`
- `PUT /api/admin/lock-settings`
- `GET /api/admin/lock-events`
- `GET /api/admin/punches?employee_id=`
- `GET /uploads/:file`: Access uploaded selfies (Admin token required)
