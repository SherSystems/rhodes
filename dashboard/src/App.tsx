import { useState } from "react";
import { useSSE } from "./hooks/useSSE";
import { useClusterPolling, useIncidentPolling } from "./hooks/usePolling";
import { useStore } from "./store";
import Header from "./components/Header";
import EventStream from "./components/EventStream";
import TopologyMap from "./components/TopologyMap";
import ActivePlan from "./components/ActivePlan";
import Resources from "./components/Resources";
import Nodes from "./components/Nodes";
import Incidents from "./components/Incidents";
import Governance from "./components/Governance";
import Chaos from "./components/Chaos";
import Migrations from "./components/Migrations";
import AppTopology from "./components/AppTopology";
import CommandPalette from "./components/CommandPalette";
import ToastContainer from "./components/Toast";
import type { TabId } from "./types";

const TABS: { id: TabId; label: string; icon?: string }[] = [
  { id: "topology", label: "Topology", icon: "🔗" },
  { id: "plan", label: "Active Plan" },
  { id: "resources", label: "Resources" },
  { id: "nodes", label: "Nodes" },
  { id: "incidents", label: "Incidents" },
  { id: "governance", label: "Governance" },
  { id: "apps", label: "Applications", icon: "🔗" },
  { id: "chaos", label: "Chaos", icon: "⚡" },
  { id: "migrations", label: "Migrations" },
];

export function App() {
  useSSE();
  useClusterPolling();
  useIncidentPolling();

  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const activeIncidents = useStore((s) => s.activeIncidents);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <>
      <Header />

      <div className="main">
        <div className="col-left">
          <div className="tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`tab${activeTab === tab.id ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon && <span style={{ marginRight: 4 }}>{tab.icon}</span>}
                {tab.label}
                {tab.id === "incidents" && (
                  <span className={`tab-badge${activeIncidents.length === 0 ? " zero" : ""}`}>
                    {activeIncidents.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div style={{ position: "relative" }}>
            {activeTab === "topology" && <TopologyMap />}
            {activeTab === "plan" && <ActivePlan />}
            {activeTab === "resources" && <Resources />}
            {activeTab === "nodes" && <Nodes />}
            {activeTab === "incidents" && <Incidents />}
            {activeTab === "governance" && <Governance />}
            {activeTab === "apps" && <AppTopology />}
            {activeTab === "chaos" && <Chaos />}
            {activeTab === "migrations" && <Migrations />}
          </div>
        </div>

        <div className={`col-right${sidebarOpen ? " mobile-open" : ""}`}>
          <button
            className="sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close event stream"
          >
            &times;
          </button>
          <EventStream />
        </div>
        {sidebarOpen && (
          <div
            className="sidebar-overlay"
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </div>

      {/* Floating button to open EventStream sidebar on mobile */}
      <button
        className="sidebar-fab"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open event stream"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      </button>

      <CommandPalette />
      <ToastContainer />
    </>
  );
}
