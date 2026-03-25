import { API } from "../api/apiService.js";

export async function getCars(filters) {
  return await API.getCars(filters);
}