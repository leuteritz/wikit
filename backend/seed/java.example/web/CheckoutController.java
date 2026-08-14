package com.acme.shop.web;

import com.acme.shop.order.Order;
import com.acme.shop.order.OrderService;
import com.acme.shop.payment.PaymentResult;

/**
 * HTTP edge. Holds no state and makes no decisions of its own — it turns a request into
 * one call on {@link OrderService} and hands the answer back.
 */
public class CheckoutController {

    private final OrderService orders;

    public CheckoutController(OrderService orders) {
        this.orders = orders;
    }

    public Order create(String customerId) {
        return orders.draftFor(customerId);
    }

    public Order addItem(String orderId, String productId, int quantity) {
        return orders.addItem(orderId, productId, quantity);
    }

    public PaymentResult checkout(String orderId) {
        return orders.place(orderId);
    }
}
