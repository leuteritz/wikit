package com.acme.shop.order;

/**
 * Where an order stands. The order moves forward only: a cancelled order never becomes
 * paid again, and that is enforced in {@link Order}, not here.
 */
public enum OrderStatus {
    DRAFT,
    PLACED,
    PAID,
    CANCELLED
}
