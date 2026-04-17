import { UI_STATE_KEY } from "./constants.js";

export const state = {
  wallet: "",
  authRoles: [],
  account: undefined,
  reputation: undefined,
  activity: [],
  recommendations: [],
  catalog: [],
  history: [],
  historyFilter: "all",
  jobHistory: [],
  catalogJobActivity: [],
  catalogActivityFilter: "all",
  selectedJobId: "",
  selectedJob: undefined,
  session: undefined,
  verification: undefined
};

export function persistUiState() {
  localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({
      wallet: state.wallet,
      selectedJobId: state.selectedJobId,
      sessionId: state.session?.sessionId ?? ""
    })
  );
}

export function readPersistedState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
