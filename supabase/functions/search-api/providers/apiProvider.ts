import type {
    SearchFilters,
    ProviderResult
} from "../types.ts";

let config: any = {};

export const apiProvider = {

    setConfig(settings: any) {

        config = settings || {};

    },

    async search(
        filters: SearchFilters
    ): Promise<ProviderResult> {

        console.log("API PROVIDER SEARCH");

        console.log("Filters:", filters);

        console.log("Config:", config);

        // Tutaj będzie:
        //
        // Carwiz
        // Avis
        // Hertz
        // Enterprise
        //
        // i kolejne API.

        return {

            success: true,

            cars: []

        };

    }

};