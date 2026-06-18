export const localProvider = {

    async search(filters) {

    console.log("LOCAL PROVIDER");

    console.log(filters);

    return [];

},

    async createBooking(data) {

        console.log("LOCAL BOOKING", data);

    },

    async cancelBooking(id) {

        console.log("LOCAL CANCEL", id);

    }

};