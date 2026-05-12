import { useSSE } from "./hooks/useSSE";
import { useClusterPolling, useIncidentPolling } from "./hooks/usePolling";
import { useStore } from "./store";
import Sidebar from "./components/layout/Sidebar";
import Overview from "./components/pages/Overview";
import Infrastructure from "./components/pages/Infrastructure";
import AppTopology from "./components/AppTopology";
import Migrations from "./components/Migrations";
import Operations from "./components/pages/Operations";
import Costs from "./components/pages/Costs";
import Chaos from "./components/Chaos";
import Health from "./components/pages/Health";
import Playbooks from "./components/pages/Playbooks";
import CommandPalette from "./components/CommandPalette";
import ToastContainer from "./components/Toast";

export function App() {
  useSSE();
  useClusterPolling();
  useIncidentPolling();

  const activeTab = useStore((s) => s.activeTab);

  return (
    <>
      <div className="app-layout">
        <Sidebar />
        <div className="app-content">
          <main className="page-content">
            {activeTab === "overview" && <Overview />}
            {activeTab === "infrastructure" && <Infrastructure />}
            {activeTab === "applications" && <AppTopology />}
            {activeTab === "migrations" && <Migrations />}
            {activeTab === "operations" && <Operations />}
            {activeTab === "costs" && <Costs />}
            {activeTab === "chaos" && <Chaos />}
            {activeTab === "health" && <Health />}
            {activeTab === "playbooks" && <Playbooks />}
          </main>
        </div>
      </div>

      <CommandPalette />
      <ToastContainer />
    </>
  );
}
