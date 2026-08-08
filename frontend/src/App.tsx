import { NavLink, Route, Routes } from "react-router-dom";
import { OverviewPage } from "./pages/OverviewPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { ApplicationDetailPage } from "./pages/ApplicationDetailPage";
import { ReviewPage } from "./pages/ReviewPage";
import { FillOutcomesPage } from "./pages/FillOutcomesPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { EnqueuePage } from "./pages/EnqueuePage";
import { SettingsPage } from "./pages/SettingsPage";
import { useTheme } from "./hooks/useTheme";
import { formatCountdown, useArmStatus } from "./hooks/useArmStatus";
import { Link } from "react-router-dom";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/applications", label: "Applications", end: false },
  { to: "/runs", label: "Runs", end: false },
  { to: "/review", label: "Review queue", end: false },
  { to: "/enqueue", label: "Enqueue", end: false },
  { to: "/fill-outcomes", label: "Fill outcomes", end: false },
  { to: "/settings", label: "Settings", end: false },
];

export function App(): JSX.Element {
  const { theme, cycle } = useTheme();
  const { status: arm } = useArmStatus();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          jobright<span>·console</span>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <button className="ghost" onClick={cycle} style={{ textAlign: "left" }}>
          theme: {theme}
        </button>
        <div className="foot">
          localhost only · mutations need the boot token
        </div>
      </aside>

      <main className="main">
        {arm?.armed ? (
          <Link
            to="/"
            className="armed-banner"
            title="An unattended session is live"
          >
            ⚡ ARMED — unattended submits live · {formatCountdown(arm.seconds_remaining)} left ·{" "}
            {arm.submits_used}/{arm.max_submits} submits · {arm.apps_started}/{arm.max_apps} apps
          </Link>
        ) : null}
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/enqueue" element={<EnqueuePage />} />
          <Route path="/fill-outcomes" element={<FillOutcomesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={<div className="banner warn">No such page.</div>}
          />
        </Routes>
      </main>
    </div>
  );
}
