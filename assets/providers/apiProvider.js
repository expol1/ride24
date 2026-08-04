let config = {};

function supabaseClient() {
    const client = window.supabaseClient;
    if (!client?.functions?.invoke) {
        throw new Error("Supabase client is not initialized");
    }
    return client;
}

function partnerId() {
    const id = config.partner_id || config.id || null;
    if (!id) throw new Error("Brak partner_id");
    return id;
}

async function invoke(functionName, body) {
    const { data, error } = await supabaseClient().functions.invoke(functionName, { body });
    if (error) throw new Error(error.message || `Błąd funkcji ${functionName}`);
    if (data?.error) throw new Error(data.error);
    return data;
}

export const apiProvider = {
    // Do przeglądarki trafia wyłącznie identyfikator partnera. Dane dostępowe API
    // pozostają w prywatnej tabeli i są używane tylko przez Edge Functions.
    setConfig(settings) {
        config = {
            partner_id: settings?.partner_id || settings?.id || null
        };
    },

    getConfig() {
        return { ...config };
    },

    async testConnection() {
        return await invoke("api-partner-admin", {
            action: "test",
            partner_id: partnerId()
        });
    },

    async syncLocations() {
        return await invoke("api-partner-admin", {
            action: "sync",
            partner_id: partnerId()
        });
    },

    async syncVehicleGroups() {
        // Backend synchronizuje lokalizacje i grupy atomowo z tego samego snapshotu.
        return await invoke("api-partner-admin", {
            action: "sync",
            partner_id: partnerId()
        });
    },

    async search(filters) {
        return await invoke("search-api", filters || {});
    },

    async createBooking(data) {
        return await invoke("create-booking-request", data || {});
    },

    async cancelBooking(id) {
        return await invoke("client-cancel-booking", {
            booking_id: id
        });
    }
};
