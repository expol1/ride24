import { API } from "../api/apiService.js";

export async function createBooking(data) {
  return await API.createBooking(data);
}