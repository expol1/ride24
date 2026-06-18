export const apiProvider = {

    async testConnection() {
        console.log("API Test");
    },

    async syncLocations() {
        console.log("Sync Locations");
    },

    async syncVehicleGroups() {
        console.log("Sync Vehicle Groups");
    },

    async search(filters) {
        console.log("Search", filters);
        return [];
    },

    async createBooking(data) {
        console.log("Create Booking", data);
    },

    async cancelBooking(id) {
        console.log("Cancel Booking", id);
    }

};