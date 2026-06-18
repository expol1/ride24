import { localProvider } from "./localProvider.js";
import { apiProvider } from "./apiProvider.js";

export const providerManager = {

    getProvider(partner) {

        if (partner?.provider_type === "api") {

            apiProvider.setConfig(partner.api_settings);

            return apiProvider;

        }

        return localProvider;

    }

};