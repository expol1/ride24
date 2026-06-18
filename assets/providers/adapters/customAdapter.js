export const customAdapter = {

    normalizeLocations(data = []) {

        return data.map(location => ({

            external_id: location.external_id,

            country: location.country,

            region: location.region,

            city: location.city,

            location_name: location.location_name,

            active: location.active !== false

        }));

    },

    normalizeVehicleGroups(data = []) {

        return data.map(group => ({

            external_id: group.external_id,

            class_code: group.class_code,

            example_model: group.example_model,

            transmission: group.transmission,

            fuel_type: group.fuel_type,

            seats: group.seats,

            bags: group.bags,

            image: group.image,

            description: group.description,

            features: group.features,

            active: group.active !== false

        }));

    },

    normalizeCars(data = []) {

        return data;

    }

};