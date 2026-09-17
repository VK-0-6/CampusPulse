# Student Feedback & Community Improvement System
> **Phase 1, 2 & 3: Foundation, Class System, and Two-Channel Feedback Collection**
> A modern academic web platform built with Vanilla JavaScript, HTML5, CSS3, Vite, and Supabase.

---

## 1. Project Overview

The **Student Feedback & Community Improvement System** is a college community service project designed to establish a continuous feedback loop:
`Student Experience -> Feedback -> AI Analysis -> Problem Identification -> Action -> Follow-up -> Improvement`

### Phases Implemented:
* **Phase 1: Foundation & Authentication**:
  * Role-based accounts: **Student**, **Faculty**, and **HOD / Department Admin**.
  * User profile management in `public.profiles`.
  * Secure route guards, session persistence, and friendly error handling.
* **Phase 2: Academic & Class Management System**:
  * Clean Semester catalog (Semesters 1 to 8) and dynamic course additions.
  * Faculty class creation with automatic, collision-resistant 6-character code generation (e.g., `K7P4XZ`).
  * Enforced single active class per faculty for the same subject/semester with duplicate safeguards.
  * Student course enrollment via 6-character class codes with case-normalization and validation.
  * Faculty roster viewing to inspect enrolled students (Name, Email, Join Date).
* **Phase 3: Feedback Collection (Two Independent Channels)**:
  * **Channel 1 — Class / Learning Feedback**:
    * Faculty starts live feedback sessions with custom Learning Concept / Topic (and optional Unit).
    * Enrolled students view active sessions and submit structured feedback (5 dimensions: understanding, clarity, pace, difficulty, doubts addressed, plus optional comments).
    * Guaranteed single submission per student per session enforced at the database level (`uq_session_student`).
    * Faculty can close sessions when class ends, permanently stopping new submissions while retaining responses and response count badges.
  * **Channel 2 — Academic Environment Issue Reporting**:
    * Dedicated channel for infrastructure and environmental problems (projector, Wi-Fi, lab computers, lab equipment, furniture, electrical, classroom conditions, other).
    * Severity selection (Low, Medium, High) with precise location and problem description.
    * Confidential / Anonymous submission support.

> **Scope Note**: Phase 3 focuses solely on clean feedback collection and storage. AI analysis, sentiment scoring, and analytics dashboards belong to future phases.

---

## 2. Technology Stack

* **Frontend**: Vanilla JavaScript (ES Modules), Semantic HTML5, Modern CSS3
* **Build Tool & Dev Server**: [Vite](https://vitejs.dev/)
* **Backend as a Service**: [Supabase](https://supabase.com/)
  * Supabase Auth (Email & Password)
  * PostgreSQL Database
  * Row Level Security (RLS)
* **Package Manager**: npm

---

## 3. Project Directory Structure

```text
student-feedback-system/
│
├── index.html              # Academic portal landing page
├── login.html              # Role-aware login page
├── register.html           # Registration page (Name, Email, Password, Role)
│
├── student/
│   └── index.html          # Student dashboard (Enrolled classes, live feedback, environment reporting)
├── faculty/
│   └── index.html          # Faculty dashboard (Class creation, student rosters, feedback sessions)
├── hod/
│   └── index.html          # HOD / Department Admin placeholder dashboard
│
├── css/
│   ├── style.css           # Global academic design system & resets
│   ├── auth.css            # Form, card, role selection & loading styles
│   └── dashboard.css       # Topbar, role badges, class & feedback cards, rating inputs
│
├── js/
│   ├── supabase.js                # Supabase client initialization & env verification
│   ├── auth.js                    # Session management, signUp, signIn, guards
│   ├── academicService.js         # Department, semester, and subject queries
│   ├── classService.js            # Class code generator, creation, enrollment, roster
│   ├── feedbackSessionService.js  # Live feedback sessions management (Phase 3)
│   ├── feedbackService.js         # Student feedback submissions & validation (Phase 3)
│   ├── departmentIssueService.js  # Infrastructure & environment issues reporting (Phase 3)
│   └── utils.js                   # Validation, alert banners, loading helpers
│
├── supabase/
│   └── schema.sql          # Complete PostgreSQL schema, RLS policies, & seed data
│
├── assets/                 # Static media & icons
├── .env                    # Local environment variables (gitignored)
├── .env.example            # Template for environment variables
├── .gitignore              # Git ignore rules protecting credentials
├── package.json            # Vite & @supabase/supabase-js dependencies
├── vite.config.js          # Multi-page application (MPA) rollup configuration
└── README.md               # Project documentation & setup instructions
```

---

## 4. Setup & Installation Instructions

### Prerequisites
* [Node.js](https://nodejs.org/) (v18.0.0 or higher recommended)
* npm (comes bundled with Node.js)
* A free [Supabase](https://supabase.com) account

### Step 1: Clone or Navigate to Project
```bash
cd "C:\Users\k varun kumar\.gemini\antigravity\scratch\student-feedback-system"
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Configure Supabase Credentials
1. In your [Supabase Dashboard](https://app.supabase.com), select your project.
2. Click **Project Settings** > **API**.
3. Copy **Project URL** and **anon public key**.
4. In your project root, open `.env` and fill in the values:
   ```env
   VITE_SUPABASE_URL=https://your-project-id.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

### Step 4: Run Database Migration & Sample Data
1. In Supabase Dashboard, open **SQL Editor**.
2. Click **New query**.
3. Copy the entire contents of `supabase/schema.sql` and run it.
4. This script sets up:
   * `public.profiles`: User identity and roles (`student`, `faculty`, `hod`).
   * `public.departments`: Department catalog (`Computer Science`, `IT`, `ECE`).
   * `public.semesters`: Semester catalog (Semesters 1-8 for `2025-2026`).
   * `public.subjects`: Course catalog (`Data Mining`, `Operating Systems`, `Java Programming`, etc.).
   * `public.classes`: Active classes with unique 6-character codes.
   * `public.class_members`: Student enrollments with composite unique constraints.
   * `public.class_feedback_sessions`: Live faculty-created learning feedback sessions.
   * `public.class_feedback`: Structured student feedback responses with `(session_id, student_id)` unique constraint.
   * `public.department_issues`: Academic infrastructure and environment issue reports.
   * **RLS Policies & Helpers**: Non-recursive `SECURITY DEFINER` helpers and policies preventing cross-user tampering.
   * **Idempotent Seed Data**: Sample departments, semesters, and subjects ready for testing.

### Step 5: Disable Email Confirmation (Recommended for Local Dev)
In Supabase Dashboard under **Authentication** > **Providers** > **Email**, toggle **Confirm email** to **OFF** to permit immediate sign-in.

### Step 6: Start the Development Server
```bash
npm run dev
```
Open your browser and navigate to `http://localhost:5173`.

---

## 5. Phase 2 Features & Workflows

### Faculty Workflow:
1. Log in as a user registered with the **Faculty** role.
2. Navigate to the Faculty Dashboard (`/faculty/`).
3. Under **Create a New Class**:
   * Select a Semester (e.g., `Semester 4 (2025-2026)`).
   * Select a Subject (e.g., `Data Mining (CS401)`).
   * Click **Create Class**.
4. A unique 6-character alphanumeric code is automatically generated (e.g., `K7P4XZ`).
5. The class immediately appears under **My Classes** with enrolled count (`👥 0`).
6. Click **View Students** to open the class roster modal.

### Student Workflow:
1. Log in as a user registered with the **Student** role.
2. Navigate to the Student Dashboard (`/student/`).
3. Under **Join a Class**:
   * Enter the 6-character code (lowercase inputs like `k7p4xz` are automatically normalized to `K7P4XZ`).
   * Click **Join Class**.
4. The system validates:
   * Code exists in `public.classes`.
   * Class is active.
   * Student is not already enrolled.
5. Upon joining, the class appears under **My Classes** with subject name, course code, semester, and instructor name.

---

## 6. Build for Production

To compile an optimized production build:
```bash
npm run build
```
The output is bundled into the `dist/` directory.
