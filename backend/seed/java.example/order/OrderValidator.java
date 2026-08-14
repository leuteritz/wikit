package com.acme.shop.order;

/**
 * The rules an order must satisfy before it may be placed. One method on purpose:
 * every caller asks the same question, and the answer is either "fine" or an exception.
 */
public class OrderValidator {

    private static final int MAX_LINES = 50;

    public void check(Order order) {
        if (order.status() != OrderStatus.DRAFT) {
            throw new IllegalStateException("Only a draft can be placed");
        }
        if (order.lines().isEmpty()) {
            throw new IllegalStateException("An order needs at least one line");
        }
        if (order.lines().size() > MAX_LINES) {
            throw new IllegalStateException("Too many lines: " + order.lines().size());
        }
        if (order.total().isZero()) {
            throw new IllegalStateException("An order cannot total zero");
        }
    }
}
