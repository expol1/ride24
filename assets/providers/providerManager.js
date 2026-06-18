import { localProvider } from "./localProvider.js";
import { apiProvider } from "./apiProvider.js";

export const providerManager = {

    getProvider(partner) {

        if (!partner) {
            return localProvider;
        }

        if (
            partner.provider_type === "api" &&
            partner.api_enabled === true
        ) {

            apiProvider.setConfig(partner.api_settings);

            return apiProvider;

        }

        return localProvider;

    },

    async search(partner, filters) {

        const provider = this.getProvider(partner);

        return await provider.search(filters);

    },

    async createBooking(partner, booking) {

        const provider = this.getProvider(partner);

        return await provider.createBooking(booking);

    },

    async cancelBooking(partner, bookingId) {

        const provider = this.getProvider(partner);

        return await provider.cancelBooking(bookingId);

    }

};