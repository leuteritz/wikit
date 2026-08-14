package com.acme.shop.order;

import com.acme.shop.util.Money;

import java.util.ArrayList;
import java.util.List;

/**
 * A customer's order and the only place that knows how its status may change.
 * It starts as DRAFT and moves forward — never back.
 */
public class Order {

    private final String id;
    private final String customerId;
    private final List<OrderLine> lines = new ArrayList<>();
    private OrderStatus status = OrderStatus.DRAFT;

    public Order(String id, String customerId) {
        this.id = id;
        this.customerId = customerId;
    }

    public String id() {
        return id;
    }

    public String customerId() {
        return customerId;
    }

    public void addLine(OrderLine line) {
        if (status != OrderStatus.DRAFT) {
            throw new IllegalStateException("Only a draft can take new lines");
        }
        lines.add(line);
    }

    public List<OrderLine> lines() {
        return lines;
    }

    /** Sum of every line. An empty order is zero, not an error — it just cannot be placed. */
    public Money total() {
        Money sum = Money.of(0L, "EUR");
        for (OrderLine line : lines) {
            sum = sum.plus(line.total());
        }
        return sum;
    }

    public OrderStatus status() {
        return status;
    }

    public void markPaid() {
        if (status == OrderStatus.CANCELLED) {
            throw new IllegalStateException("A cancelled order cannot be paid");
        }
        status = OrderStatus.PAID;
    }

    public void cancel() {
        if (status == OrderStatus.PAID) {
            throw new IllegalStateException("A paid order needs a refund, not a cancellation");
        }
        status = OrderStatus.CANCELLED;
    }
}
