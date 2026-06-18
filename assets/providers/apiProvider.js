let config = {};

export const apiProvider = {

    setConfig(settings) {
        config = settings || {};
    },

    getConfig() {
        return config;
    },

    async testConnection() {
        console.log("API Test", config);
    },

    async syncLocations() {
        console.log("Sync Locations", config);
    },

    async syncVehicleGroups() {
        console.log("Sync Vehicle Groups", config);
    },

    async search(filters) {
        console.log("Search", filters, config);
        return [];
    },

    async createBooking(data) {
        console.log("Create Booking", data, config);
    },

    async cancelBooking(id) {
        console.log("Cancel Booking", id, config);
    }

};