import axios from 'axios';

export function apiClient() {
  const baseURL = process.env.BACKEND_URL || 'http://localhost:3000';
  return axios.create({
    baseURL,
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' }
  });
}
