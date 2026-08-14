package com.acme.shop.order;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Where orders are kept. In-memory here — the point is that everything above it
 * only ever calls save/findById and never learns where the data actually lives.
 */
public class OrderRepository {

    private final Map<String, Order> byId = new HashMap<>();

    public void save(Order order) {
        byId.put(order.id(), order);
    }

    public Order findById(String orderId) {
        return byId.get(orderId);
    }

    public List<Order> all() {
        return new ArrayList<>(byId.values());
    }
}
