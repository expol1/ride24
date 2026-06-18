export function normalizeCars(cars: any[]): any[] {

    if (!cars || !Array.isArray(cars)) {
        return [];
    }

    return cars.map(car => ({

        ...car,

        provider_type:
            car.provider_type ?? "local",

        external_id:
            car.external_id ?? null,

        is_api_managed:
            car.is_api_managed ?? false

    }));

}