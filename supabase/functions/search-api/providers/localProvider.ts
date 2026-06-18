import type {
    SearchFilters,
    ProviderResult
} from "../types.ts";

export const localProvider = {

    async search(
        filters: SearchFilters
    ): Promise<ProviderResult> {

        console.log("LOCAL PROVIDER SEARCH");
        console.log(filters);

        // W następnym etapie
        // tutaj pobierzemy auta z bazy Ride24

        return {

            success: true,

            cars: []

        };

    }

};