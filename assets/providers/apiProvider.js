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

    console.log("API SEARCH");

    console.log("Filters:", filters);

    console.log("Config:", config);

    // Tutaj później wywołamy API partnera

    return [];

},

    async createBooking(data) {
        console.log("Create Booking", data, config);
    },

    async cancelBooking(id) {
        console.log("Cancel Booking", id, config);
    }

};