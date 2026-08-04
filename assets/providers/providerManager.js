import { localProvider } from "./localProvider.js";
import { apiProvider } from "./apiProvider.js";

export const providerManager = {
    getProvider(partner) {
        if (!partner) return localProvider;

        if (partner.provider_type === "api" && partner.api_enabled === true) {
            // Nie przekazujemy api_settings ani żadnych sekretów do przeglądarki.
            apiProvider.setConfig({ partner_id: partner.id });
            return apiProvider;
        }

        return localProvider;
    },

    async search(partner, filters) {
        return await this.getProvider(partner).search(filters);
    },

    async createBooking(partner, booking) {
        return await this.getProvider(partner).createBooking(booking);
    },

    async cancelBooking(partner, bookingId) {
        return await this.getProvider(partner).cancelBooking(bookingId);
    }
};
