import { appState } from "../state/appState.js";

export function login(user) {
  appState.user = user;
}

export function logout() {
  appState.user = null;
}