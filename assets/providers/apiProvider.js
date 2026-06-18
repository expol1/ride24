let config = {};

export const apiProvider = {

    setConfig(settings) {

        config = settings || {};

    },

    getConfig() {

        return config;

    },

    async testConnection() {

        if (!config.api_url) {

            return {

                success: false,

                message: "Brak API URL"

            };

        }

        try {

            const response = await fetch(config.api_url, {

                method: "GET",

                headers: {

                    "Content-Type": "application/json",

                    "X-API-KEY": config.api_key || "",

                    "X-API-SECRET": config.api_secret || ""

                }

            });

            return {

                success: response.ok,

                status: response.status

            };

        }

        catch (e) {

            return {

                success: false,

                message: e.message

            };

        }

    },

    async syncLocations() {

    if (!config.api_url) {

        return {

            success: false,

            message: "Brak API URL"

        };

    }

    try {

        // tutaj później partner będzie zwracał listę lokalizacji

        return {

            success: true,

            locations: []

        };

    }

    catch (e) {

        return {

            success: false,

            message: e.message

        };

    }

},

    async syncVehicleGroups() {

    if (!config.api_url) {

        return {

            success: false,

            message: "Brak API URL"

        };

    }

    try {

        return {

            success: true,

            groups: []

        };

    }

    catch (e) {

        return {

            success: false,

            message: e.message

        };

    }

},

    async search(filters) {

        console.log("API SEARCH");

        console.log("Filters:", filters);

        console.log("Config:", config);

        // Tutaj później wywołamy API partnera

        return {

            success: true,

            cars: []

        };

    },

    async createBooking(data) {

        console.log("CREATE BOOKING");

        console.log(data);

        console.log(config);

        return {

            success: true

        };

    },

    async cancelBooking(id) {

        console.log("CANCEL BOOKING");

        console.log(id);

        console.log(config);

        return {

            success: true

        };

    }

};