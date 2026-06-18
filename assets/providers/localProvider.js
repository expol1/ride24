export const localProvider = {

    async search(filters) {

        console.log("LOCAL SEARCH", filters);

        return {

            success: true,

            cars: []

        };

    },

    async createBooking(data) {

        console.log("LOCAL BOOKING", data);

        return {

            success: true

        };

    },

    async cancelBooking(id) {

        console.log("LOCAL CANCEL", id);

        return {

            success: true

        };

    },

    async testConnection() {

        return {

            success: true

        };

    }

};