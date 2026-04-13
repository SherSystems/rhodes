import { useEffect, useCallback } from "react";
import { useStore } from "../store";
import { fetchCluster, fetchMultiCluster, fetchIncidents } from "../api/client";

export function useClusterPolling(intervalMs = 10000) {
  const setCluster = useStore((s) => s.setCluster);
  const setMultiCluster = useStore((s) => s.setMultiCluster);

  const poll = useCallback(async () => {
    try {
      const data = await fetchCluster();
      // Normalize VM IDs
      data.vms = data.vms.map((v) => {
        if (!v.vmid && v.id) (v as unknown as Record<string, unknown>).vmid = v.id;
        return v;
      });
      setCluster(data);
    } catch {
      // ignore polling errors
    }
    try {
      const multi = await fetchMultiCluster();
      setMultiCluster(multi);
    } catch {
      // ignore
    }
  }, [setCluster, setMultiCluster]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs]);
}

export function useIncidentPolling() {
  const setIncidents = useStore((s) => s.setIncidents);

  const load = useCallback(async () => {
    try {
      const data = await fetchIncidents();
      const active = (data.open || []).filter(
        (i) => i.status === "open" || i.status === "healing"
      );
      const recent = (data.recent || []).filter(
        (i) => i.status === "resolved" || i.status === "failed"
      );
      setIncidents(active, recent);
    } catch {
      // ignore
    }
  }, [setIncidents]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
}
