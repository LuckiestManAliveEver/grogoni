import {
  createContext,
  useContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from "react";

import type { GrogoniSessionContext } from "@grogoni/shared-types";

import type { ShellView, GrogoniMode } from "../app-shell";
import type { ActiveBusiness, AgentSettings, SessionResponse } from "../grogoni-application-shared";

export interface OwnerCoreState {
  session: SessionResponse | null;
  setSession: Dispatch<SetStateAction<SessionResponse | null>>;
  grogoniSessionContext: GrogoniSessionContext | null;
  setGrogoniSessionContext: Dispatch<SetStateAction<GrogoniSessionContext | null>>;
  business: ActiveBusiness | null;
  setBusiness: Dispatch<SetStateAction<ActiveBusiness | null>>;
  agentSettings: AgentSettings;
  setAgentSettings: Dispatch<SetStateAction<AgentSettings>>;
  view: ShellView;
  setView: Dispatch<SetStateAction<ShellView>>;
  mode: GrogoniMode;
  setMode: Dispatch<SetStateAction<GrogoniMode>>;
}

const OwnerCoreContext = createContext<OwnerCoreState | null>(null);

export function OwnerCoreProvider({
  value,
  children
}: {
  value: OwnerCoreState;
  children: ReactNode;
}) {
  return <OwnerCoreContext.Provider value={value}>{children}</OwnerCoreContext.Provider>;
}

export function useOwnerCore(): OwnerCoreState {
  const context = useContext(OwnerCoreContext);
  if (context === null) {
    throw new Error("useOwnerCore must be used within an OwnerCoreProvider");
  }
  return context;
}
