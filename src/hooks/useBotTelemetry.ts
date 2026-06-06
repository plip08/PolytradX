"use client";

import { useEffect, useMemo, useRef } from "react";
import { useBotStore } from "../store/useBotStore";
import type { BotSnapshot } from "../types";

const TELEMETRY_URL = process.env.NEXT_PUBLIC_TELEMETRY_WS_URL ?? "ws://localhost:3000/api/telemetry";

export function useBotTelemetry() {
  const token = useBotStore((state) => state.token);
  const setWsConnected = useBotStore((state) => state.setWsConnected);
  const applySnapshot = useBotStore((state) => state.applySnapshot);
  const wsRef = useRef<WebSocket | null>(null);

  const url = useMemo(() => {
    const parsed = new URL(TELEMETRY_URL, window.location.href);
    if (token) {
      parsed.searchParams.set("token", token);
    }
    return parsed.toString();
  }, [token]);

  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setWsConnected(true);
    });

    ws.addEventListener("close", () => {
      setWsConnected(false);
    });

    ws.addEventListener("error", () => {
      setWsConnected(false);
      ws.close();
    });

    ws.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data) as BotSnapshot;
        applySnapshot(payload);
      } catch {
        // ignore invalid telemetry packets
      }
    });

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [url, applySnapshot, setWsConnected]);
}
