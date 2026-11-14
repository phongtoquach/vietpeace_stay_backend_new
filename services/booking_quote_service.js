const TAX_BPS = Number(process.env.BOOKING_TAX_BPS ?? 0);
function toCents(value) {
  return Math.round(Number(value) * 100);
}
function fromCents(value) {
  return value / 100;
}

function calculateQuote(accommodationId, selectedRooms, roomById, totalNights) {
  let roomsSubtotal = 0;
  let extraGuestTotal = 0;

  const quotedRooms = selectedRooms.map((selection, index) => {
    const { roomTypeId, adults, children } = selection;
    const room = roomById.get(roomTypeId);
    const subtotal = toCents(room.roomSubtotal);

    const extraAdultTotal =
      Math.max(0, adults - room.includedAdults) *
      toCents(room.extraAdultFeePerNight) *
      totalNights;

    const extraChildTotal =
      Math.max(0, children - room.includedChildren) *
      toCents(room.extraChildFeePerNight) *
      totalNights;

    roomsSubtotal += subtotal;
    extraGuestTotal += extraAdultTotal + extraChildTotal;

    return {
      roomId: `room-${accommodationId}-${roomTypeId}-${index + 1}`,
      roomTypeId,
      includedAdults: room.includedAdults,
      includedChildren: room.includedChildren,
      adults,
      children,
      maxAdults: room.maxAdults,
      maxChildren: room.maxChildren,
      maxOccupancy: room.maxOccupancy,
      roomSubtotal: room.roomSubtotal,
      extraAdultFeePerNight: room.extraAdultFeePerNight,
      extraChildFeePerNight: room.extraChildFeePerNight,
      extraAdultTotal: fromCents(extraAdultTotal),
      extraChildTotal: fromCents(extraChildTotal),
      discountAmount: 0,
      totalAmount: fromCents(subtotal + extraAdultTotal + extraChildTotal),
      nightlyRates: room.nightlyRates,
    };
  });

  if (!Number.isInteger(TAX_BPS) || TAX_BPS < 0 || TAX_BPS > 10000) {
    throw new Error("BOOKING_TAX_BPS không hợp lệ.");
  }

  const taxableAmount = roomsSubtotal + extraGuestTotal;
  const taxAmount = Math.round((taxableAmount * TAX_BPS) / 10000);

  return {
    roomsSubtotal: fromCents(roomsSubtotal),
    extraGuestTotal: fromCents(extraGuestTotal),
    roomDiscountTotal: 0,
    discountAmount: 0,
    taxAmount: fromCents(taxAmount),
    totalAmount: fromCents(taxableAmount + taxAmount),
    selectedRooms: quotedRooms,
  };
}

module.exports = { calculateQuote, toCents, fromCents };
