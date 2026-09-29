// js/supabase.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { auth } from "./firebase.js";
import { SUPABASE_URL, AVATAR_BUCKET } from "./avatar.js";

const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhuYmVnYndwcWhoZmJuaHdqYnV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0OTU0NDMsImV4cCI6MjEwNjA3MTQ0M30.2_3nEFLW0IBU6X-ZM0PhMxyNzBc4iHRP9901t1a1ky4";

export { AVATAR_BUCKET };

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  // 요청마다 현재 Firebase 유저의 ID 토큰을 Authorization 헤더로 보냄
  accessToken: async () => (await auth.currentUser?.getIdToken()) ?? null,
});