import { carClasses } from "../mock/carClasses.js";
import { bookings as defaultBookings } from "../mock/bookings.js";
import { calculatePricing } from "../modules/pricing.js";

// Funkcje pomocnicze do synchronizacji bazy między zakładkami (RAM -> LocalStorage)
function getBookings() {
    const stored = localStorage.getItem('ride24_mock_bookings');
    return stored ? JSON.parse(stored) : defaultBookings;
}

function saveBookings(data) {
    localStorage.setItem('ride24_mock_bookings', JSON.stringify(data));
}

export const API = {
  
  // 1. Sprawdzanie dostępności dla danej Klasy Auta
  async checkAvailability(carClassId, pickupDate, returnDate) {
    const bookings = getBookings();
    const classBookings = bookings.filter(b => b.car_id === carClassId && b.booking_status !== 'rejected' && b.booking_status !== 'cancelled' && b.booking_status !== 'expired');
    const reqStart = new Date(pickupDate);
    const reqEnd = new Date(returnDate);

    for (let b of classBookings) {
      const bStart = new Date(b.pickup_date);
      const bEnd = new Date(b.return_date);
      // Jeśli daty się nakładają, auto jest niedostępne
      if (reqStart <= bEnd && reqEnd >= bStart) return false;
    }
    return true;
  },

  // 2. Pobieranie floty z wykorzystaniem PRICING ENGINE
  async getCars(filters) {
    const availableClasses = [];
    for (let carClass of carClasses) {
        
        // Magia: Przeliczamy ceny przez nasz algorytm (narzucając marżę platformy)
        const pricing = calculatePricing(carClass.public_price_day, carClass.partner_discount_percent, 25);
        
        // Tłumaczymy nowy model na stare nazwy, by nie popsuć innych plików UI
        const classObj = {
            ...carClass,
            class: carClass.class_code, 
            brand: carClass.brand_model.split(" ")[0], 
            model: carClass.brand_model.split(" ").slice(1).join(" "), 
            pricing: pricing, // Podpinamy wyliczone ceny
            currency: carClass.currency // <-- DODANE
        };

        if (filters && filters.pickup_date && filters.drop_date) {
            const isAvailable = await this.checkAvailability(carClass.id, filters.pickup_date, filters.drop_date);
            if (isAvailable) availableClasses.push(classObj);
        } else {
            availableClasses.push(classObj);
        }
    }
    return availableClasses;
  },

  // Pobieranie pojedynczej klasy (ze wsparciem Pricing Engine)
  async getCarById(id) {
    const carClass = carClasses.find(c => c.id === id);
    if (carClass) {
        const pricing = calculatePricing(carClass.public_price_day, carClass.partner_discount_percent, 25);
        return {
            ...carClass,
            class: carClass.class_code,
            brand: carClass.brand_model.split(" ")[0],
            model: carClass.brand_model.split(" ").slice(1).join(" "),
            pricing: pricing,
            currency: carClass.currency // <-- DODANE
        };
    }
    return null;
  },

  // 3. Tworzenie rezerwacji (Ze SNAPSHOTAMI i datą ważności)
  async createBooking(data) {
    const bookings = getBookings();
    const isAvailable = await this.checkAvailability(data.car_id, data.pickup_date, data.return_date);
    if (!isAvailable) throw new Error("Wybrana klasa jest zajęta w tym terminie.");

    // Odpytujemy naszą klasę, żeby zapisać "Snapshot" cen w momencie zakupu
    const carClass = await this.getCarById(data.car_id);
    const pricing = carClass.pricing;

    // Obliczamy liczbę dni
    const start = new Date(data.pickup_date);
    const end = new Date(data.return_date);
    const days = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));

    // Tworzymy daty
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + (24 * 60 * 60 * 1000)); // Ważność: +24h dla Partnera

    const booking = {
      id: Date.now(),
      booking_code: "R24-" + Math.floor(1000 + Math.random() * 9000), // np. R24-4821
      ...data, // Wrzuca m.in client_id, car_id, daty
      
      // --- SNAPSHOTY FINANSOWE (Cena per dzień * liczba dni) ---
      partner_public_price_snapshot: pricing.publicPrice * days,
      partner_discount_snapshot: pricing.partnerDiscount,
      partner_net_price_snapshot: pricing.partnerNetPrice * days,
      platform_margin_snapshot: pricing.platformMargin,
      final_price_snapshot: pricing.finalPrice * days,
      commission_snapshot: pricing.commission * days,
      
      // Zmienne używane bezpośrednio do wyświetlania na UI:
      price: pricing.finalPrice * days, // Finalna kwota za cały wynajem (to widzi klient)
      online_pln: Math.round(pricing.commission * days * 4.3), // Zaliczka płatna z góry u nas na bramce (przelicznik x4.3)
      pickup_partner_currency: pricing.partnerNetPrice * days, // Kwota, którą klient dopłaci na miejscu u Partnera
      partner_currency: carClass.currency, // <-- DODANE (zamiast sztywnego 'EUR')

      booking_status: "pending",
      stripe_session_id: null, // Puste miejsce gotowe na integrację płatności
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString()
    };
    
    bookings.push(booking);
    saveBookings(bookings);
    return booking;
  },

  async getClientBookings(clientId) {
    return getBookings().filter(b => b.client_id === clientId);
  },

  async getPartnerBookings(partnerId) {
    return getBookings().filter(b => b.partner_id === partnerId);
  },

  async updateBookingStatus(bookingId, newStatus) {
    const bookings = getBookings();
    const booking = bookings.find(b => b.id === bookingId);
    if (booking) {
      booking.booking_status = newStatus;
      saveBookings(bookings);
    }
    return booking;
  }
};