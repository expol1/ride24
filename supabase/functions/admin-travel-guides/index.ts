import { requireAdmin } from "../_shared/ride24-security.ts";
import { createGuideHandler, type Guide, type GuideStore } from "./handler.ts";

const handler = createGuideHandler({
  fetch,
  authorize: async (req): Promise<GuideStore> => {
    const { admin } = await requireAdmin(req);
    return {
      getToken: async () => {
        const { data, error } = await admin.rpc("admin_travel_guide_github_token");
        if (error) throw new Error("Guide configuration unavailable");
        return typeof data === "string" && data ? data : null;
      },
      setToken: async (token) => {
        const { error } = await admin.rpc("admin_travel_guide_github_token", { p_token: token });
        if (error) throw new Error("Guide configuration unavailable");
      },
      findGuides: async (slug) => {
        const { data, error } = await admin.from("travel_guides")
          .select("id,title,slug,folder_name,active")
          .or(`slug.eq.${slug},folder_name.eq.${slug}`).limit(2);
        if (error) throw new Error("Guide lookup failed");
        return (data || []) as Guide[];
      },
      insertGuide: async (title, slug) => {
        const { data, error } = await admin.from("travel_guides")
          .insert({ title, slug, folder_name: slug, active: true })
          .select("id,title,slug,folder_name,active").single();
        if (error || !data) throw new Error("Guide registration failed");
        return data as Guide;
      },
    };
  },
});
Deno.serve(handler);
