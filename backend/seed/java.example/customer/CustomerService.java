package com.acme.shop.customer;

import com.acme.shop.util.Ids;

import java.util.HashMap;
import java.util.Map;

/**
 * The customer records and the one question the rest of the shop asks about them:
 * "may this person order?" — answered by {@link #require(String)}, which throws if not.
 */
public class CustomerService {

    private final Map<String, Customer> customers = new HashMap<>();

    public Customer register(String name) {
        Customer customer = new Customer(Ids.newCustomerId(), name, true);
        customers.put(customer.id(), customer);
        return customer;
    }

    public Customer findById(String customerId) {
        return customers.get(customerId);
    }

    /**
     * Guard, not a getter: it either returns the customer or refuses. Callers that only
     * need the name use {@link #findById(String)} instead.
     */
    public Customer require(String customerId) {
        Customer customer = findById(customerId);
        if (customer == null) {
            throw new IllegalArgumentException("Unknown customer: " + customerId);
        }
        if (!customer.isActive()) {
            throw new IllegalStateException("Customer is not active: " + customerId);
        }
        return customer;
    }
}
