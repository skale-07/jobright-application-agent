import { NavLink, Route, Routes } from "react-router-dom";
import { OverviewPage } from "./pages/OverviewPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { ApplicationDetailPage } from "./pages/ApplicationDetailPage";
import { ReviewPage } from "./pages/ReviewPage";
import { FillOutcomesPage } from "./pages/FillOutcomesPage";
import { useTheme } from "./hooks/useTheme";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/applications", label: "Applications", end: false },
  { to: "/review", label: "Review queue", end: false },
  { to: "/fill-outcomes", label: "Fill outcomes", end: false },
];

export function App(): JSX.Element {
  const { theme, cycle } = useTheme();

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
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/fill-outcomes" element={<FillOutcomesPage />} />
          <Route
            path="*"
            element={<div className="banner warn">No such page.</div>}
          />
        </Routes>
      </main>
    </div>
  );
}
