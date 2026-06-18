export function normalizeLocations(provider, locations = []) {

    return locations.map(location => ({

        provider,

        external_id: location.external_id || "",

        country: location.country || "",

        region: location.region || "",

        city: location.city || "",

        location_name: location.location_name || "",

        active: location.active !== false

    }));

}