package com.acme.shop.util;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Identifiers for new records. One counter per kind, so an order id never collides
 * with a customer id even though both are just numbers with a prefix.
 */
public final class Ids {

    private static final AtomicLong ORDERS = new AtomicLong(1000L);
    private static final AtomicLong CUSTOMERS = new AtomicLong(1L);

    private Ids() {
    }

    public static String newOrderId() {
        return "ORD-" + ORDERS.incrementAndGet();
    }

    public static String newCustomerId() {
        return "CUS-" + CUSTOMERS.incrementAndGet();
    }
}
