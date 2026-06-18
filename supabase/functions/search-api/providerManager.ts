import { localProvider } from "./providers/localProvider.ts";
import { apiProvider } from "./providers/apiProvider.ts";

import type {
    ProviderConfig,
    SearchFilters,
    ProviderResult
} from "./types.ts";

export class ProviderManager {

    static async search(

        provider: ProviderConfig,

        filters: SearchFilters

    ): Promise<ProviderResult> {

        if (provider.provider === "local") {

            return await localProvider.search(filters);

        }

        apiProvider.setConfig(provider.settings);

        return await apiProvider.search(filters);

    }

}