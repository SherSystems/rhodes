import type { ReactNode } from "react";
import { useStore } from "../../store";
import type { PageId } from "../../types";

interface NavItem {
  id: PageId;
  label: string;
  icon: ReactNode;
}

const navItems: (NavItem | "divider")[] = [
  {
    id: "overview",
    label: "Overview",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="1" width="6" height="6" rx="1" />
        <rect x="11" y="1" width="6" height="6" rx="1" />
        <rect x="1" y="11" width="6" height="6" rx="1" />
        <rect x="11" y="11" width="6" height="6" rx="1" />
      </svg>
    ),
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="14" height="4" rx="1" />
        <rect x="2" y="8" width="14" height="4" rx="1" />
        <rect x="2" y="14" width="14" height="2" rx="1" />
        <circle cx="5" cy="4" r="0.5" fill="currentColor" />
        <circle cx="5" cy="10" r="0.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "applications",
    label: "Applications",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="4" r="2" />
        <circle cx="4" cy="14" r="2" />
        <circle cx="14" cy="14" r="2" />
        <line x1="9" y1="6" x2="5" y2="12" />
        <line x1="9" y1="6" x2="13" y2="12" />
        <line x1="6" y1="14" x2="12" y2="14" />
      </svg>
    ),
  },
  {
    id: "migrations",
    label: "Migrations",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="2" y1="6" x2="16" y2="6" />
        <polyline points="12,3 16,6 12,9" />
        <line x1="16" y1="12" x2="2" y2="12" />
        <polyline points="6,9 2,12 6,15" />
      </svg>
    ),
  },
  {
    id: "operations",
    label: "Operations",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 1L2 5v6c0 3.5 3 6.5 7 8 4-1.5 7-4.5 7-8V5L9 1z" />
        <polyline points="6,9 8,11 12,7" />
      </svg>
    ),
  },
  {
    id: "costs",
    label: "Costs",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="9" y1="2" x2="9" y2="16" />
        <path d="M12.5 5.5c0-1.4-1.6-2.5-3.5-2.5S5.5 4.1 5.5 5.5 7.1 8 9 8s3.5 1.1 3.5 2.5S10.9 13 9 13s-3.5-1.1-3.5-2.5" />
      </svg>
    ),
  },
  "divider",
  {
    id: "health",
    label: "Health",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 9 L5 9 L7 4 L11 14 L13 9 L16 9" />
      </svg>
    ),
  },
  {
    id: "playbooks",
    label: "Playbooks",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 2 h10 a2 2 0 0 1 2 2 v12 l-3 -2 l-3 2 l-3 -2 l-3 2 V4 a2 2 0 0 1 2 -2 z" />
        <line x1="6" y1="7" x2="12" y2="7" />
        <line x1="6" y1="10" x2="10" y2="10" />
      </svg>
    ),
  },
  {
    id: "chaos",
    label: "Chaos",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9,1 11,7 9,6 11,11 9,10 12,17" />
        <polyline points="6,1 8,7 6,6 8,11 6,10 9,17" />
      </svg>
    ),
  },
];

export default function Sidebar() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const connected = useStore((s) => s.connected);
  const activeIncidents = useStore((s) => s.activeIncidents);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/rhodes-logo.png" alt="RHODES" width="28" height="28" style={{ borderRadius: '6px', display: 'block' }} />
        <span className="sidebar-logo-text">
          RHO<span className="brand-accent">DES</span>
        </span>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item, i) => {
          if (item === "divider") {
            return <div key={`divider-${i}`} className="sidebar-divider" />;
          }
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              className={`sidebar-nav-item${isActive ? " active" : ""}`}
              onClick={() => setActiveTab(item.id)}
            >
              <span className="sidebar-nav-icon">{item.icon}</span>
              <span className="sidebar-nav-label">{item.label}</span>
              {item.id === "operations" && activeIncidents.length > 0 && (
                <span className="sidebar-nav-badge">{activeIncidents.length}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <span className={`conn-dot${connected ? " live" : ""}`} />
        <span className="sidebar-footer-text">
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>
    </aside>
  );
}
