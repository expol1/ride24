export function normalizeCars(provider, cars = []) {

    return cars.map(car => ({

        provider,

        external_id: car.external_id || "",

        class_code: car.class_code || "",

        example_model: car.example_model || "",

        transmission: car.transmission || "",

        fuel_type: car.fuel_type || "",

        seats: Number(car.seats || 0),

        bags: Number(car.bags || 0),

        image: car.image || "",

        public_price: Number(car.public_price || 0),

        currency: car.currency || "EUR",

        supplier: car.supplier || "",

        location: car.location || "",

        available: car.available !== false

    }));

}